//! A picture you pick for a playlist cover: cropped square, scaled to 640 px and saved as a JPEG under
//! Spotify's 256 KB limit, as base64 (what Spotify's upload expects).

use base64::Engine;
use image::imageops::FilterType;
use std::io::Cursor;
use std::path::Path;

pub fn jpeg_base64(path: &Path) -> Option<String> {
    // Don't read anything huge: a cover photo is a few MB at most.
    if std::fs::metadata(path).ok()?.len() > 50 * 1024 * 1024 { return None; }
    let img = image::ImageReader::open(path).ok()?.with_guessed_format().ok()?.decode().ok()?;
    let side = img.width().min(img.height());
    if side == 0 { return None; }
    let square = img.crop_imm((img.width() - side) / 2, (img.height() - side) / 2, side, side);
    let resized = square.resize_exact(640, 640, FilterType::Lanczos3).to_rgb8();
    let mut quality = 90u8;
    while quality > 20 {
        let mut out = Cursor::new(Vec::new());
        let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality);
        if enc.encode_image(&resized).is_ok() {
            let b64 = base64::engine::general_purpose::STANDARD.encode(out.into_inner());
            if b64.len() < 250_000 { return Some(b64); }
        }
        quality -= 10;
    }
    None
}

#[cfg(test)]
mod tests {
    #[test]
    fn makes_a_square_jpeg_under_spotifys_limit() {
        let p = std::env::temp_dir().join(format!("cadenza-cover-{}.png", std::process::id()));
        let img = image::RgbImage::from_fn(1200, 800, |x, y| image::Rgb([(x % 256) as u8, (y % 256) as u8, ((x ^ y) % 256) as u8]));
        img.save(&p).unwrap();
        let b64 = super::jpeg_base64(&p).expect("a cover");
        assert!(b64.len() < 250_000);
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD.decode(b64).unwrap();
        let back = image::load_from_memory(&bytes).unwrap();
        assert_eq!((back.width(), back.height()), (640, 640));
        let _ = std::fs::remove_file(p);
    }
}
