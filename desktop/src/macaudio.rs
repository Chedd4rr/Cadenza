
use std::ffi::{c_char, c_void, CStr};

#[repr(C)]
struct Address { selector: u32, scope: u32, element: u32 }

#[link(name = "CoreAudio", kind = "framework")]
extern "C" {
    fn AudioObjectGetPropertyDataSize(id: u32, addr: *const Address, qsize: u32, q: *const c_void, size: *mut u32) -> i32;
    fn AudioObjectGetPropertyData(id: u32, addr: *const Address, qsize: u32, q: *const c_void, size: *mut u32, data: *mut c_void) -> i32;
    fn AudioObjectSetPropertyData(id: u32, addr: *const Address, qsize: u32, q: *const c_void, size: u32, data: *const c_void) -> i32;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFStringGetCString(s: *const c_void, buf: *mut c_char, size: isize, encoding: u32) -> u8;
    fn CFRelease(p: *const c_void);
}

const fn code(s: &[u8; 4]) -> u32 { u32::from_be_bytes(*s) }

const SYSTEM: u32 = 1;                                    // kAudioObjectSystemObject
const GLOBAL: u32 = code(b"glob");
const OUTPUT: u32 = code(b"outp");
const DEVICES: u32 = code(b"dev#");
const DEFAULT_OUTPUT: u32 = code(b"dOut");
const DEFAULT_SYSTEM_OUTPUT: u32 = code(b"sOut");       // alerts and system sounds
const UID: u32 = code(b"uid ");
const NAME: u32 = code(b"lnam");
const TRANSPORT: u32 = code(b"tran");
const STREAMS: u32 = code(b"stm#");
const NOMINAL_RATE: u32 = code(b"nsrt");
const AVAILABLE_RATES: u32 = code(b"nsr#");             // AudioValueRange[]
const HOG_MODE: u32 = code(b"oink");
const UTF8: u32 = 0x0800_0100;

pub struct Output { pub id: u32, pub uid: String, pub name: String, pub transport: &'static str }

fn addr(selector: u32, scope: u32) -> Address { Address { selector, scope, element: 0 } }

fn u32_property(id: u32, selector: u32) -> u32 {
    let a = addr(selector, GLOBAL);
    let mut v: u32 = 0;
    let mut size = 4u32;
    // SAFETY: the property is a single UInt32 and `size` says so.
    unsafe { AudioObjectGetPropertyData(id, &a, 0, std::ptr::null(), &mut size, &mut v as *mut u32 as *mut c_void) };
    v
}

fn string_property(id: u32, selector: u32) -> String {
    let a = addr(selector, GLOBAL);
    let mut s: *const c_void = std::ptr::null();
    let mut size = std::mem::size_of::<*const c_void>() as u32;
    // SAFETY: the property is a CFStringRef, which we own afterwards and release.
    let status = unsafe { AudioObjectGetPropertyData(id, &a, 0, std::ptr::null(), &mut size, &mut s as *mut _ as *mut c_void) };
    if status != 0 || s.is_null() { return String::new(); }
    let mut buf = [0 as c_char; 512];
    // SAFETY: the buffer is as long as we say; the string is released once copied.
    let ok = unsafe { CFStringGetCString(s, buf.as_mut_ptr(), buf.len() as isize, UTF8) };
    unsafe { CFRelease(s) };
    if ok == 0 { return String::new(); }
    // SAFETY: CFStringGetCString wrote a terminated string into buf.
    unsafe { CStr::from_ptr(buf.as_ptr()) }.to_string_lossy().into_owned()
}

fn has_output(id: u32) -> bool {
    let a = addr(STREAMS, OUTPUT);
    let mut size = 0u32;
    // SAFETY: only asks for the size.
    unsafe { AudioObjectGetPropertyDataSize(id, &a, 0, std::ptr::null(), &mut size) == 0 && size > 0 }
}

fn transport(id: u32) -> &'static str {
    match &u32_property(id, TRANSPORT).to_be_bytes() {
        b"blue" | b"blea" => "bluetooth",
        b"bltn" => "builtin",
        b"usb " => "usb",
        b"airp" => "airplay",
        b"hdmi" | b"dprt" => "display",
        b"virt" | b"grup" | b"fgrp" => "virtual",
        _ => "other",
    }
}

pub fn default_output() -> u32 { u32_property(SYSTEM, DEFAULT_OUTPUT) }

pub fn default_output_rate() -> Option<f64> { device_rate(default_output()) }

/// The rate an output runs at, in Hz.
pub fn device_rate(dev: u32) -> Option<f64> {
    let a = addr(NOMINAL_RATE, GLOBAL);
    let mut v: f64 = 0.0;
    let mut size = 8u32;
    // SAFETY: the property is a single Float64 and `size` says so.
    let status = unsafe { AudioObjectGetPropertyData(dev, &a, 0, std::ptr::null(), &mut size, &mut v as *mut f64 as *mut c_void) };
    if status == 0 && v > 0.0 { Some(v) } else { None }
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Range { min: f64, max: f64 }

/// Whether an output can run at this rate.
pub fn supports_rate(dev: u32, hz: f64) -> bool {
    let a = addr(AVAILABLE_RATES, GLOBAL);
    let mut size = 0u32;
    // SAFETY: size query, then a buffer of exactly that many AudioValueRanges.
    if unsafe { AudioObjectGetPropertyDataSize(dev, &a, 0, std::ptr::null(), &mut size) } != 0 || size == 0 { return false; }
    let mut list = vec![Range::default(); size as usize / std::mem::size_of::<Range>()];
    if list.is_empty() { return false; }
    if unsafe { AudioObjectGetPropertyData(dev, &a, 0, std::ptr::null(), &mut size, list.as_mut_ptr() as *mut c_void) } != 0 { return false; }
    list.truncate(size as usize / std::mem::size_of::<Range>());
    list.iter().any(|r| hz >= r.min - 1.0 && hz <= r.max + 1.0)
}

pub fn set_rate(dev: u32, hz: f64) -> bool {
    let a = addr(NOMINAL_RATE, GLOBAL);
    // SAFETY: the property is a single Float64.
    unsafe { AudioObjectSetPropertyData(dev, &a, 0, std::ptr::null(), 8, &hz as *const f64 as *const c_void) == 0 }
}

pub fn hog(dev: u32, on: bool) -> bool {
    let a = addr(HOG_MODE, GLOBAL);
    let me = std::process::id() as i32;
    let mut owner: i32 = -1;
    let mut size = 4u32;
    // SAFETY: the property is a single pid_t (Int32).
    unsafe { AudioObjectGetPropertyData(dev, &a, 0, std::ptr::null(), &mut size, &mut owner as *mut i32 as *mut c_void) };
    if on && owner == me { return true; }
    if !on && owner != me { return true; }                 // not ours to give back
    if on && owner != -1 { return false; }                 // another app has it
    let want: i32 = if on { me } else { -1 };
    // SAFETY: as above. Setting it to our own pid takes the device; -1 gives it back.
    unsafe { AudioObjectSetPropertyData(dev, &a, 0, std::ptr::null(), 4, &want as *const i32 as *const c_void) == 0 }
}

pub fn outputs() -> Vec<Output> {
    let a = addr(DEVICES, GLOBAL);
    let mut size = 0u32;
    // SAFETY: size query, then a buffer of exactly that many device ids.
    if unsafe { AudioObjectGetPropertyDataSize(SYSTEM, &a, 0, std::ptr::null(), &mut size) } != 0 || size == 0 { return vec![]; }
    let mut ids = vec![0u32; size as usize / 4];
    if unsafe { AudioObjectGetPropertyData(SYSTEM, &a, 0, std::ptr::null(), &mut size, ids.as_mut_ptr() as *mut c_void) } != 0 { return vec![]; }
    ids.truncate(size as usize / 4);
    let order = |t: &str| ["bluetooth", "builtin", "usb", "airplay", "display", "other", "virtual"].iter().position(|x| *x == t).unwrap_or(9);
    let mut list: Vec<Output> = ids.into_iter().filter(|&id| has_output(id))
        .map(|id| Output { id, uid: string_property(id, UID), name: string_property(id, NAME), transport: transport(id) })
        .filter(|o| !o.uid.is_empty() && !o.uid.starts_with("CADefaultDeviceAggregate") && !o.name.starts_with("CADefaultDeviceAggregate"))
        .collect();
    list.sort_by(|a, b| (order(a.transport), &a.name).cmp(&(order(b.transport), &b.name)));
    list
}

pub fn set_default(uid: &str) -> bool {
    let Some(o) = outputs().into_iter().find(|o| o.uid == uid) else { return false };
    let id = o.id;
    let a = addr(DEFAULT_OUTPUT, GLOBAL);
    // SAFETY: the property is a single AudioDeviceID (UInt32).
    let ok = unsafe { AudioObjectSetPropertyData(SYSTEM, &a, 0, std::ptr::null(), 4, &id as *const u32 as *const c_void) } == 0;
    let s = addr(DEFAULT_SYSTEM_OUTPUT, GLOBAL);
    unsafe { AudioObjectSetPropertyData(SYSTEM, &s, 0, std::ptr::null(), 4, &id as *const u32 as *const c_void) };
    ok
}
