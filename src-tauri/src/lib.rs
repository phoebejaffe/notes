use std::fs;
use std::io::Cursor;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[derive(Deserialize, Serialize)]
struct SavedGeometry {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
            }

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
            TrayIconBuilder::new()
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
            let handler_shortcut = shortcut.clone();
            app.handle().plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(move |app, registered_shortcut, event| {
                        if registered_shortcut == &handler_shortcut
                            && event.state() == ShortcutState::Pressed
                        {
                            toggle_shortcut_window(app);
                        }
                    })
                    .build(),
            )?;
            app.global_shortcut().register(shortcut)?;
            Ok(())
        })
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
