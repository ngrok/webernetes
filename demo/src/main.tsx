import { installDevPerformanceMeasureCleanup } from "./dev-performance";
import { MantleStyleSheets, ThemeProvider, mantleStyleSheetUrls } from "@ngrok/mantle/theme";
import { TooltipProvider } from "@ngrok/mantle/tooltip";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import darkHighContrastCssUrl from "@ngrok/mantle/mantle-dark-high-contrast.css?url";
import darkCssUrl from "@ngrok/mantle/mantle-dark.css?url";
import lightHighContrastCssUrl from "@ngrok/mantle/mantle-light-high-contrast.css?url";
import "./styles.css";
import { App } from "./app";

const root = document.getElementById("root");
if (!root) {
	throw new Error("Missing root element");
}

installDevPerformanceMeasureCleanup();

const themeUrls = mantleStyleSheetUrls({
	darkCssUrl,
	lightHighContrastCssUrl,
	darkHighContrastCssUrl,
});

createRoot(root).render(
	<StrictMode>
		<ThemeProvider>
			<MantleStyleSheets {...themeUrls} />
			<TooltipProvider>
				<App />
			</TooltipProvider>
		</ThemeProvider>
	</StrictMode>,
);
