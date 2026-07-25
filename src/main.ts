import { getCurrentWindow } from "@tauri-apps/api/window";
import { createPinia } from "pinia";
import { createApp } from "vue";
import App from "./ui/App.vue";
import "./ui/fonts.css";
import "./ui/tokens.css";

createApp(App).use(createPinia()).mount("#app");

requestAnimationFrame(() => {
    void getCurrentWindow()
    .show()
    .catch(() => {});
});
