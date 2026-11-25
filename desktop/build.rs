fn main() {
    // The built-in engine's librespot version (librespot.sh writes it next to the source), for the
    // engine log and diagnostics.
    println!("cargo:rerun-if-changed=librespot-src/.cadenza-version");
    if let Ok(v) = std::fs::read_to_string("librespot-src/.cadenza-version") {
        let commit = v.trim().split('-').next().unwrap_or("");
        let short: String = commit.chars().take(7).collect();
        println!("cargo:rustc-env=CADENZA_LIBRESPOT_VERSION=0.8.0 ({short})");
    }
    tauri_build::build()
}
