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
    let install_src = Path::new(&manifest_dir).join("../install/mihomo-config.default.yaml");

    fs::create_dir_all(&assets_dir).ok();

    // Prefer repo template; never stage an empty file (empty assets/ would poison the binary).
    let src = if install_src.is_file() && file_nonempty(&install_src) {
        install_src
    } else if dst.is_file() && file_nonempty(&dst) {
        dst.clone()
    } else {
        panic!(
            "mihomo-config.default.yaml missing or empty; expected non-empty {} or {}",
            Path::new(&manifest_dir)
                .join("../install/mihomo-config.default.yaml")
                .display(),
            dst.display()
        );
    };

    if src != dst {
        fs::copy(&src, &dst).expect("failed to stage mihomo-config.default.yaml");
    }
    println!("cargo:rerun-if-changed={}", src.display());
    println!("cargo:rerun-if-changed={}", dst.display());
}

fn file_nonempty(path: &Path) -> bool {
    fs::metadata(path).map(|m| m.len() > 64).unwrap_or(false)
}
