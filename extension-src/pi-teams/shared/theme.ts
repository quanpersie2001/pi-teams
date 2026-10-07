// Structural theme surface shared by UI feature renderers.
//
// Features must not import concrete Pi theme classes; they style through this
// `(colorToken, text) => string` function shape, which every Pi Theme
// satisfies via its `fg` method. Tests pass plain ANSI-emitting stubs.

/**
 * Color tokens UI features use. Deliberately a subset of Pi's ThemeColor so
 * any real Pi Theme satisfies this shape.
 */
export type UiColorToken =
	| "accent"
	| "border"
	| "borderMuted"
	| "dim"
	| "error"
	| "muted"
	| "success"
	| "text"
	| "warning";

/** Structural view of Pi's `Theme.fg`. */
export type ThemeFg = (color: UiColorToken, text: string) => string;

/**
 * Bind a Pi theme's `fg` method and make it crash-proof.
 *
 * Pi's `Theme.fg(color, text)` is a METHOD that reads `this.fgColors` (an
 * instance Map built in the constructor). Extracting `theme.fg` and calling it
 * detached sets `this` to `undefined`, which throws
 * "Cannot read properties of undefined (reading 'fgColors')" and kills the
 * whole TUI on the first panel repaint. Every UI feature must style through
 * this helper so (a) `this` stays bound and (b) a theme hiccup degrades to
 * plain text instead of crashing the render path.
 */
export function bindThemeFg(theme: { fg: ThemeFg }): ThemeFg {
	const fg = theme.fg.bind(theme);
	return (color, text) => {
		try {
			return fg(color, text);
		} catch {
			return text;
		}
	};
}
