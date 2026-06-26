import { RadioGroup } from "@ngrok/mantle/radio-group";
import { useAppliedTheme, useTheme } from "@ngrok/mantle/theme";

export function ThemeToggle() {
	const [theme, setTheme] = useTheme();
	const appliedTheme = useAppliedTheme();
	const isDark = appliedTheme === "dark" || appliedTheme === "dark-high-contrast";

	return (
		<RadioGroup.ButtonGroup
			className="demo-theme-toggle"
			value={isDark ? "dark" : "light"}
			onChange={(value) => setTheme(value as "light" | "dark")}
			aria-label={theme === "system" ? `Theme, using system theme (${appliedTheme})` : "Theme"}
		>
			<RadioGroup.Button value="light" aria-label="Light theme">
				<SunIcon />
			</RadioGroup.Button>
			<RadioGroup.Button value="dark" aria-label="Dark theme">
				<MoonIcon />
			</RadioGroup.Button>
		</RadioGroup.ButtonGroup>
	);
}

function SunIcon() {
	return (
		<svg
			aria-hidden="true"
			className="size-4 text-orange-500"
			fill="none"
			stroke="currentColor"
			strokeLinecap="round"
			strokeLinejoin="round"
			strokeWidth="2"
			viewBox="0 0 24 24"
		>
			<circle cx="12" cy="12" r="4" />
			<path d="M12 2v2" />
			<path d="M12 20v2" />
			<path d="m4.93 4.93 1.41 1.41" />
			<path d="m17.66 17.66 1.41 1.41" />
			<path d="M2 12h2" />
			<path d="M20 12h2" />
			<path d="m6.34 17.66-1.41 1.41" />
			<path d="m19.07 4.93-1.41 1.41" />
		</svg>
	);
}

function MoonIcon() {
	return (
		<svg aria-hidden="true" className="size-4 text-sky-700" fill="currentColor" viewBox="0 0 24 24">
			<path d="M21 14.8A8.5 8.5 0 0 1 9.2 3a7 7 0 1 0 11.8 11.8Z" />
		</svg>
	);
}
