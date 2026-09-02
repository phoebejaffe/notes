use std::io::Cursor;

use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
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
                        toggle_main_window(&app_handle);
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
                            toggle_main_window(app);
                        }
                    })
                    .build(),
            )?;
            app.global_shortcut().register(shortcut)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}
