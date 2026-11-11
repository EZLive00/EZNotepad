fn main() {
    // tauri_build::build() 只把 tauri.conf.json / capabilities 声明成
    // rerun-if-changed；但它生成的 Windows resource.rc 里是
    //   32512 ICON "<绝对路径>/icons/icon.ico"
    // 由 rc.exe 编进 resource.lib。也就是说，换图标文件本身并不会让
    // build script 重跑，增量构建出来的 exe 会一直带着第一次那个图标
    // （任务栏 / Alt+Tab / 资源管理器全是旧的），只有 clean build 才对。
    // 把整个 icons/ 补进依赖，换图标就必须重新编译资源。
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
