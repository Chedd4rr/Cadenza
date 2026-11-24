//! The Mac's sound outputs, straight from Core Audio: each one's unique id
//! (which the per-device EQ is saved under), its name and kind, and
//! switching the system's output. Cadenza's sound then follows the system output, as on Linux.

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

/// Core Audio names its properties with four letters packed into a number.
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

/// The outputs, in this order: Bluetooth, built-in, USB, AirPlay, displays, others.
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
        // Core Audio makes hidden "CADefaultDeviceAggregate-…" devices for apps' own sound; they aren't speakers.
        .filter(|o| !o.uid.is_empty() && !o.uid.starts_with("CADefaultDeviceAggregate") && !o.name.starts_with("CADefaultDeviceAggregate"))
        .collect();
    list.sort_by(|a, b| (order(a.transport), &a.name).cmp(&(order(b.transport), &b.name)));
    list
}

/// Makes this output the Mac's sound output (and for alerts too, so they follow your headphones).
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
