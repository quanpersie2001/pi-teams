import type { Theme } from "@earendil-works/pi-coding-agent";

/** Render a normalized teammate identity color, falling back to a visible theme accent. */
export function identityColor(theme: Theme, color: string | undefined, text: string): string {
	if (!color || !/^#[\da-f]{6}$/i.test(color)) return theme.fg("borderAccent", text);
	const red = Number.parseInt(color.slice(1, 3), 16);
	const green = Number.parseInt(color.slice(3, 5), 16);
	const blue = Number.parseInt(color.slice(5, 7), 16);
	const cube = (value: number) => Math.round((value / 255) * 5);
	const code =
		theme.getColorMode() === "256color"
			? `38;5;${16 + 36 * cube(red) + 6 * cube(green) + cube(blue)}`
			: `38;2;${red};${green};${blue}`;
	return `\x1b[${code}m${text}\x1b[39m`;
}
