//! Opening Cadenza when you log in.
//!
//! On a Mac this uses Apple's own login items for apps (SMAppService), as the Swift app did, so System
//! Settings → Login Items lists Cadenza under "Open at Login" with its icon. (The usual cross-platform way
//! writes a launch agent that points at the program inside the app, which shows up as a bare "cadenza"
//! with a blank icon.) Windows and Linux use the autostart plugin.

use tauri::AppHandle;

pub fn enabled(app: &AppHandle) -> bool {
    #[cfg(target_os = "macos")]
    { let _ = app; mac::status() == 1 }
    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_autostart::ManagerExt;
        app.autolaunch().is_enabled().unwrap_or(false)
    }
}

pub fn set(app: &AppHandle, on: bool) -> bool {
    #[cfg(target_os = "macos")]
    {
        remove_old_launch_agent(app);
        mac::set(on)
    }
    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_autostart::ManagerExt;
        let al = app.autolaunch();
        (if on { al.enable() } else { al.disable() }).is_ok()
    }
}

/// Builds from before this change made a launch agent instead: if one is there, move it over to a proper
/// login item, so it's on once and with the right name and icon.
pub fn tidy(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_autostart::ManagerExt;
        if app.autolaunch().is_enabled().unwrap_or(false) {
            remove_old_launch_agent(app);
            if mac::set(true) { log::info!("open at login: moved to a macOS login item"); }
        }
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = app; }
}

#[cfg(target_os = "macos")]
fn remove_old_launch_agent(app: &AppHandle) {
    use tauri_plugin_autostart::ManagerExt;
    let _ = app.autolaunch().disable();
}

#[cfg(target_os = "macos")]
mod mac {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject, Bool};

    #[link(name = "ServiceManagement", kind = "framework")]
    extern "C" {}

    /// The login item for this app: [SMAppService mainAppService].
    fn service() -> Option<&'static AnyObject> {
        let class = AnyClass::get(c"SMAppService")?;
        // SAFETY: a class method that returns the shared object for this app (never released).
        let svc: *mut AnyObject = unsafe { msg_send![class, mainAppService] };
        // SAFETY: checked for null; the object lives as long as the app.
        unsafe { svc.as_ref() }
    }

    /// 0 not registered, 1 on, 2 waiting for you to allow it in System Settings, 3 not found.
    pub fn status() -> isize {
        let Some(svc) = service() else { return 0 };
        // SAFETY: `status` takes nothing and returns an NSInteger.
        unsafe { msg_send![svc, status] }
    }

    pub fn set(on: bool) -> bool {
        let Some(svc) = service() else { return false };
        let mut error: *mut AnyObject = std::ptr::null_mut();
        // SAFETY: both methods take an NSError** and return a BOOL.
        let ok: Bool = unsafe {
            if on { msg_send![svc, registerAndReturnError: &mut error] }
            else { msg_send![svc, unregisterAndReturnError: &mut error] }
        };
        if !ok.as_bool() { log::warn!("couldn't {} the login item", if on { "add" } else { "remove" }); }
        // Turning it off when it was never on counts as done.
        ok.as_bool() || (!on && status() != 1)
    }
}
