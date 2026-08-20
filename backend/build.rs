use std::env;
use std::fs;
use std::path::Path;

fn main() {
    println!(
        "cargo:rustc-env=BUILD_TARGET={}",
        env::var("TARGET").unwrap_or_else(|_| "unknown".into())
    );

    let manifest_dir = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let assets_dir = Path::new(&manifest_dir).join("assets");
    let dst = assets_dir.join("mihomo-config.default.yaml");

    let sources = [
        Path::new(&manifest_dir).join("../install/mihomo-config.default.yaml"),
        dst.clone(),
    ];

    fs::create_dir_all(&assets_dir).ok();

    for src in &sources {
        if src.exists() {
            fs::copy(src, &dst).expect("failed to stage mihomo-config.default.yaml");
            println!("cargo:rerun-if-changed={}", src.display());
            return;
        }
    }

    panic!(
        "mihomo-config.default.yaml not found; expected ../install/mihomo-config.default.yaml or assets/mihomo-config.default.yaml"
    );
}
