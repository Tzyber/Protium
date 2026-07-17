// binary-entrypoint; logik in lib.rs (auch für mobile/tests wiederverwendbar).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    protium_lib::run()
}
