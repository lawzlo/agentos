fn main() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os == "macos" {
        cc::Build::new()
            .file("src/macos_bridge.m")
            .flag("-fobjc-arc")
            .compile("agentos_native_macos");

        for framework in [
            "Foundation",
            "AppKit",
            "ApplicationServices",
            "CoreGraphics",
            "Vision",
            "ImageIO",
        ] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
    }
}
