import { defineStore } from "pinia";
import type { Game } from "../../core/types";
import { useLibraryStore } from "./libraryStore";

export type ViewId = "library" | "proton";

export const useUiStore = defineStore("ui", {
  state: () => ({
    activeView: "library" as ViewId,
    selectedGame: null as Game | null, // offenes detail-drawer
  }),
  actions: {
    go(view: ViewId) {
      this.activeView = view;
    },
    openGame(game: Game) {
      this.selectedGame = game;
    },
    closeGame() {
      this.selectedGame = null;
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
