fn main() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    println!("cargo:rerun-if-changed=build.rs");
    if target_os == "macos" {
        println!("cargo:rerun-if-changed=src/macos_bridge.m");
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
