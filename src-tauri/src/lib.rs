use std::fs;
use std::io::Cursor;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[derive(Deserialize, Serialize)]
struct SavedGeometry {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

struct CaptureShortcut(Arc<Mutex<Shortcut>>);

#[derive(Deserialize, Serialize)]
struct BackupDocument {
    day: String,
    markdown: String,
}

fn geometry_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|path| path.join("window-geometry.json"))
}

fn default_window_size(app: &AppHandle) -> PhysicalSize<u32> {
    let height = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|monitor| (monitor.size().height as f64 * 0.75) as u32)
        .unwrap_or(600)
        .max(120);
    PhysicalSize::new(520, height)
}

fn is_geometry_visible(app: &AppHandle, geometry: &SavedGeometry) -> bool {
    app.available_monitors()
        .map(|monitors| {
            monitors.into_iter().any(|monitor| {
                let monitor_position = monitor.position();
                let monitor_size = monitor.size();
                let monitor_right = monitor_position.x + monitor_size.width as i32;
                let monitor_bottom = monitor_position.y + monitor_size.height as i32;
                geometry.x < monitor_right
                    && geometry.x + geometry.width.min(100) as i32 > monitor_position.x
                    && geometry.y < monitor_bottom
                    && geometry.y + geometry.height.min(48) as i32 > monitor_position.y
            })
        })
        .unwrap_or(false)
}

fn restore_window_geometry(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let fallback_size = default_window_size(app);
    let Some(path) = geometry_path(app) else {
        let _ = window.set_size(fallback_size);
        return;
    };
    let restored = fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<SavedGeometry>(&bytes).ok())
        .filter(|geometry| geometry.width >= 360 && geometry.height >= 120)
        .filter(|geometry| is_geometry_visible(app, geometry));

    if let Some(geometry) = restored {
        let _ = window.set_size(PhysicalSize::new(geometry.width, geometry.height));
        let _ = window.set_position(PhysicalPosition::new(geometry.x, geometry.y));
    } else {
        let _ = window.set_size(fallback_size);
    }
}

fn save_window_geometry(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Some(path) = geometry_path(app) else {
        return;
    };
    let Ok(position) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.inner_size() else {
        return;
    };
    let Some(directory) = path.parent() else {
        return;
    };
    if fs::create_dir_all(directory).is_ok() {
        let geometry = SavedGeometry {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        };
        if let Ok(bytes) = serde_json::to_vec(&geometry) {
            let _ = fs::write(path, bytes);
        }
    }
}

fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        let _ = app.emit("quick-entry-focus", ());
    }
}

fn toggle_shortcut_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_focused().unwrap_or(false) {
            save_window_geometry(app);
            let _ = window.hide();
        } else {
            focus_main_window(app);
        }
    }
}

fn toggle_tray_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            save_window_geometry(app);
            let _ = window.hide();
        } else {
            focus_main_window(app);
        }
    }
}

#[tauri::command]
fn set_capture_window_always_on_top(app: AppHandle, always_on_top: bool) -> Result<(), String> {
    app.get_webview_window("main")
        .ok_or_else(|| "Main window is unavailable".to_string())?
        .set_always_on_top(always_on_top)
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
fn hide_standard_window_buttons(window: &tauri::WebviewWindow) -> Result<(), String> {
    let ns_window_ptr = window.ns_window().map_err(|error| error.to_string())?;
    let ns_window = unsafe { &*(ns_window_ptr as *mut objc2_app_kit::NSWindow) };
    for button in [
        objc2_app_kit::NSWindowButton::CloseButton,
        objc2_app_kit::NSWindowButton::MiniaturizeButton,
        objc2_app_kit::NSWindowButton::ZoomButton,
    ] {
        if let Some(button) = ns_window.standardWindowButton(button) {
            button.setHidden(true);
        }
    }
    Ok(())
}

#[tauri::command]
fn set_capture_window_opacity(app: AppHandle, opacity: f64) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "Main window is unavailable".to_string())?;
        let ns_window_ptr = window.ns_window().map_err(|error| error.to_string())?;
        let ns_window = unsafe { &*(ns_window_ptr as *mut objc2_app_kit::NSWindow) };
        ns_window.setOpaque(false);
        let clear_color = objc2_app_kit::NSColor::clearColor();
        ns_window.setBackgroundColor(Some(&clear_color));
        ns_window.setAlphaValue(opacity.clamp(0.5, 1.0));
        return Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, opacity);
        Err("Window opacity is currently supported on macOS only".to_string())
    }
}

#[tauri::command]
fn set_capture_shortcut(app: AppHandle, state: tauri::State<'_, CaptureShortcut>, shortcut: String) -> Result<(), String> {
    let parsed = Shortcut::from_str(&shortcut).map_err(|error| error.to_string())?;
    let mut current = state.0.lock().map_err(|_| "Shortcut state is unavailable".to_string())?;
    if *current == parsed {
        return Ok(())
    }
    app.global_shortcut().unregister(current.clone()).map_err(|error| error.to_string())?;
    if let Err(error) = app.global_shortcut().register(parsed.clone()) {
        let _ = app.global_shortcut().register(current.clone());
        return Err(error.to_string())
    }
    *current = parsed;
    Ok(())
}

#[tauri::command]
fn set_app_visibility(app: AppHandle, show_menu_bar: bool, show_dock_icon: bool) -> Result<(), String> {
    if !show_menu_bar && !show_dock_icon {
        return Err("At least one app entry point must remain visible".to_string())
    }
    if let Some(tray) = app.tray_by_id("notes-tray") {
        tray.set_visible(show_menu_bar).map_err(|error| error.to_string())?;
    }
    if let Some(window) = app.get_webview_window("main") {
        window.set_skip_taskbar(!show_dock_icon).map_err(|error| error.to_string())?;
    }
    #[cfg(target_os = "macos")]
    app.set_activation_policy(if show_dock_icon { tauri::ActivationPolicy::Regular } else { tauri::ActivationPolicy::Accessory }).map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn set_launch_at_login(_app: AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME").ok_or_else(|| "Home directory is unavailable".to_string())?;
        let directory = PathBuf::from(home).join("Library/LaunchAgents");
        let path = directory.join("com.notes.desktop.plist");
        if enabled {
            fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
            let executable = std::env::current_exe().map_err(|error| error.to_string())?;
            let plist = format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\"><plist version=\"1.0\"><dict><key>Label</key><string>com.notes.desktop</string><key>ProgramArguments</key><array><string>{}</string></array><key>RunAtLoad</key><true/></dict></plist>", executable.display());
            fs::write(path, plist).map_err(|error| error.to_string())?;
        } else if path.exists() {
            fs::remove_file(path).map_err(|error| error.to_string())?;
        }
        return Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (_app, enabled);
        Err("Launch at login is currently supported on macOS only".to_string())
    }
}

fn valid_backup_day(name: &str) -> bool {
    name.len() == 13 && name.ends_with(".md") && name[..10].chars().enumerate().all(|(index, character)| {
        if index == 4 || index == 7 { character == '-' } else { character.is_ascii_digit() }
    })
}

fn generated_backup_folder(name: &str) -> bool {
    let value = name.strip_prefix("week-").unwrap_or(name);
    let date = if value.len() >= 10 { &value[..10] } else { return false };
    date.len() == 10 && date.chars().enumerate().all(|(index, character)| {
        if index == 4 || index == 7 { character == '-' } else { character.is_ascii_digit() }
    }) && (value.len() == 10 || value.len() == 13)
}

#[tauri::command]
fn cleanup_backups(root: String, cutoff: String) -> Result<Vec<String>, String> {
    let root_path = PathBuf::from(root);
    let mut removed = Vec::new();
    for entry in fs::read_dir(&root_path).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if !file_type.is_dir() { continue; }
        let name = entry.file_name().to_string_lossy().to_string();
        let value = name.strip_prefix("week-").unwrap_or(&name);
        let date = value.get(..10).unwrap_or("");
        if generated_backup_folder(&name) && date < cutoff.as_str() {
            fs::remove_dir_all(entry.path()).map_err(|error| error.to_string())?;
            removed.push(name);
        }
    }
    Ok(removed)
}

#[tauri::command]
fn read_backup(root: String) -> Result<Vec<BackupDocument>, String> {
    let mut documents = Vec::new();
    for entry in fs::read_dir(PathBuf::from(root)).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry.file_type().map_err(|error| error.to_string())?.is_file() { continue; }
        let name = entry.file_name().to_string_lossy().to_string();
        if !valid_backup_day(&name) { continue; }
        let day = name[..10].to_string();
        let markdown = fs::read_to_string(entry.path()).map_err(|error| error.to_string())?;
        documents.push(BackupDocument { day, markdown });
    }
    Ok(documents)
}

#[tauri::command]
fn write_backup(root: String, folder_name: String, documents: Vec<BackupDocument>) -> Result<Vec<String>, String> {
    let backup_folder = PathBuf::from(root).join(folder_name);
    fs::create_dir_all(&backup_folder).map_err(|error| error.to_string())?;
    let mut written = Vec::new();
    for document in documents.into_iter().filter(|document| !document.markdown.is_empty()) {
        fs::write(backup_folder.join(format!("{}.md", document.day)), document.markdown).map_err(|error| error.to_string())?;
        written.push(document.day);
    }
    Ok(written)
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_oauth::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            restore_window_geometry(app.handle());
            if let Some(window) = app.get_webview_window("main") {
                window.show()?;
                #[cfg(target_os = "macos")]
                hide_standard_window_buttons(&window)?;
            }

            let app_menu = SubmenuBuilder::new(app, "Notes")
                .about(None)
                .separator()
                .quit()
                .build()?;
            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            let keep_on_top = MenuItemBuilder::with_id("keep-on-top", "Keep on top")
                .accelerator("CmdOrCtrl+Shift+A")
                .build(app)?;
            let mut window_menu_builder = SubmenuBuilder::new(app, "Window")
                .item(&keep_on_top);
            #[cfg(target_os = "macos")]
            {
                let transparency = MenuItemBuilder::with_id("toggle-transparency", "Transparency")
                    .accelerator("CmdOrCtrl+Shift+T")
                    .build(app)?;
                let opacity_50 = MenuItemBuilder::with_id("opacity-50", "50%")
                    .build(app)?;
                let opacity_65 = MenuItemBuilder::with_id("opacity-65", "65%")
                    .build(app)?;
                let opacity_80 = MenuItemBuilder::with_id("opacity-80", "80%")
                    .build(app)?;
                let opacity_100 = MenuItemBuilder::with_id("opacity-100", "100%")
                    .build(app)?;
                let transparency_menu = SubmenuBuilder::new(app, "Transparency")
                    .items(&[&opacity_50, &opacity_65, &opacity_80, &opacity_100])
                    .build()?;
                window_menu_builder = window_menu_builder
                    .item(&transparency)
                    .item(&transparency_menu);
            }
            let window_menu = window_menu_builder
                .close_window()
                .build()?;
            let menu = MenuBuilder::new(app)
                .items(&[&app_menu, &edit_menu, &window_menu])
                .build()?;
            app.set_menu(menu)?;
            app.on_menu_event(|app, event| {
                if event.id() == "keep-on-top" {
                    if let Some(window) = app.get_webview_window("main") {
                        if let Ok(current) = window.is_always_on_top() {
                            let next = !current;
                            let _ = window.set_always_on_top(next);
                            let _ = app.emit("always-on-top-changed", next);
                        }
                    }
                }
                #[cfg(target_os = "macos")]
                if event.id() == "toggle-transparency" {
                    let _ = app.emit("toggle-window-transparency", ());
                }
                if let Some(opacity) = match event.id().as_ref() {
                    "opacity-50" => Some(0.5),
                    "opacity-65" => Some(0.65),
                    "opacity-80" => Some(0.8),
                    "opacity-100" => Some(1.0),
                    _ => None,
                } {
                    let _ = app.emit("set-window-opacity", opacity);
                }
            });

            let app_handle = app.handle().clone();
            let decoder = png::Decoder::new(Cursor::new(include_bytes!("../icons/tray-note.png")));
            let mut reader = decoder.read_info()?;
            let mut pixels = vec![0; reader.output_buffer_size().unwrap_or_default()];
            let frame = reader.next_frame(&mut pixels)?;
            let tray_icon = tauri::image::Image::new_owned(
                pixels[..frame.buffer_size()].to_vec(),
                frame.width,
                frame.height,
            );
            TrayIconBuilder::with_id("notes-tray")
                .icon(tray_icon)
                .tooltip("Notes")
                .on_tray_icon_event(move |_tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_tray_window(&app_handle);
                    }
                })
                .build(app)?;

            let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyN);
            let active_shortcut = Arc::new(Mutex::new(shortcut.clone()));
            app.manage(CaptureShortcut(Arc::clone(&active_shortcut)));
            app.handle().plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(move |app, registered_shortcut, event| {
                        let is_active = active_shortcut.lock().map(|shortcut| *shortcut == *registered_shortcut).unwrap_or(false);
                        if is_active && event.state() == ShortcutState::Pressed {
                            toggle_shortcut_window(app);
                        }
                    })
                    .build(),
            )?;
            app.global_shortcut().register(shortcut)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![set_capture_window_always_on_top, set_capture_window_opacity, set_capture_shortcut, set_app_visibility, set_launch_at_login, write_backup, cleanup_backups, read_backup])
        .on_window_event(|window, event| {
            if window.label() == "main"
                && matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_))
            {
                save_window_geometry(&window.app_handle());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}
