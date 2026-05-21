fn main() {
    // Cargo doesn't watch icon files by default, so updating icon.ico alone
    // wouldn't trigger a rebuild — the old icon stays embedded in the EXE.
    // Declare the icon as a build input so changes to it always re-link.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    tauri_build::build()
}
