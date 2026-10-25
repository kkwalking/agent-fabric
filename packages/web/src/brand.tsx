/**
 * The AgentFabric mark — the in-app form of the app icon.
 *
 * Both variants are the vector geometry of `assets/AgentFabric-logo.svg`, the
 * file the Dock icon (`packages/desktop/build/icon.icns`) is exported from, so
 * the in-app mark and the app icon cannot drift apart:
 *
 * - `tile`: the whole icon — dark rounded square plus the gradient "A". Used
 *   where the mark stands alone and should read as *the app*.
 * - `glyph`: the "A" alone, no tile. Used inline beside the product name,
 *   where the row already carries the surface.
 *
 * Gradient ids are namespaced with `useId` because two marks are on screen at
 * once (rail and footer); duplicate SVG ids would make the second one borrow
 * the first one's gradients.
 */
import { useId } from "react";

export function BrandMark({
  variant = "glyph",
  size = 24,
  className,
}: {
  variant?: "glyph" | "tile";
  size?: number;
  className?: string;
}) {
  const uid = `bm${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const cyan = `${uid}-cyan`;
  const orange = `${uid}-orange`;
  const purple = `${uid}-purple`;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      /* `glyph` crops to the "A" (with padding so the round caps are not
         clipped); `tile` shows the whole 1024 canvas the icon file uses. */
      viewBox={variant === "tile" ? "0 0 1024 1024" : "262 262 516 516"}
      aria-hidden
      focusable="false"
    >
      <defs>
          <linearGradient id={cyan} x1="285" y1="710" x2="512" y2="260" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#2E9AD9"/><stop offset=".49" stopColor="#42C5E0"/><stop offset="1" stopColor="#80EECF"/></linearGradient>
          <linearGradient id={orange} x1="394" y1="548" x2="680" y2="572" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#FFD18E"/><stop offset=".45" stopColor="#FFAE81"/><stop offset="1" stopColor="#FF7D92"/></linearGradient>
          <linearGradient id={purple} x1="505" y1="285" x2="727" y2="730" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#AE9AFF"/><stop offset=".48" stopColor="#887BFF"/><stop offset="1" stopColor="#6F6FF4"/></linearGradient>
      </defs>
      {/* The icon's tile: the dark rounded square, in the icon's own colour. */}
      {variant === "tile" && <rect x="74" y="74" width="876" height="876" rx="205" fill="#151D32" />}
      <g>
        <path d="M306 721 L448 357 Q467 304 508 303" fill="none" stroke="#050917" strokeOpacity=".42" strokeWidth="121" strokeLinecap="round" strokeLinejoin="round" transform="translate(0 16)"/>
        <path d="M306 721 L448 357 Q467 304 508 303" fill="none" stroke={`url(#${cyan})`} strokeWidth="111" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="M317 700 L458 352" fill="none" stroke="#FFFFFF" strokeOpacity=".15" strokeWidth="12" strokeLinecap="round"/>
        {/* the warm shuttle threads over the left arm and under the right */}
        <path d="M405 566 H656" stroke="#030817" strokeOpacity=".45" strokeWidth="111" strokeLinecap="round" transform="translate(0 13)"/>
        <path d="M405 566 H656" stroke={`url(#${orange})`} strokeWidth="101" strokeLinecap="round"/>
        <path d="M419 551 H604" stroke="#FFF6DE" strokeOpacity=".28" strokeWidth="10" strokeLinecap="round"/>
        {/* right leg is laid over horizontal weft */}
        <path d="M508 303 Q551 302 572 357 L718 721" fill="none" stroke="#030615" strokeOpacity=".44" strokeWidth="122" strokeLinecap="round" strokeLinejoin="round" transform="translate(0 15)"/>
        <path d="M508 303 Q551 302 572 357 L718 721" fill="none" stroke={`url(#${purple})`} strokeWidth="112" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="M540 324 Q557 341 569 374 L704 700" fill="none" stroke="#FFFFFF" strokeOpacity=".22" strokeWidth="11" strokeLinecap="round"/>
      </g>
    </svg>
  );
}
