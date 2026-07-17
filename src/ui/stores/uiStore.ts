import { defineStore } from "pinia";
import { useLibraryStore } from "./libraryStore";

export type ViewId = "library" | "proton";

export const useUiStore = defineStore("ui", {
  state: () => ({ activeView: "library" as ViewId }),
  actions: {
    go(view: ViewId) {
      this.activeView = view;
    },
    // aus dem proton-manager in die nach compat-tool gefilterte library springen
    showLibraryForTool(internalName: string) {
      const lib = useLibraryStore();
      lib.reset();
      lib.compatTools = [internalName];
      this.activeView = "library";
    },
  },
});
