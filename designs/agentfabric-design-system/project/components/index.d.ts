export type ButtonVariant = "quiet" | "primary" | "accent";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  small?: boolean;
}

/** AgentFabric button. Quiet is the default; use primary once per view; accent only for a single call to action. */
export function Button(props: ButtonProps): JSX.Element;

export type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger" | "review";

export interface BadgeProps {
  tone?: BadgeTone;
  children?: React.ReactNode;
}

/** Compact status pill with a 6px dot. One or two words; never a sentence. */
export function Badge(props: BadgeProps): JSX.Element;

export interface CardProps {
  eyebrow?: string;
  title: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
}

/** A white hairline card on the page. Elevation comes from one low shadow, not a heavy drop shadow. */
export function Card(props: CardProps): JSX.Element;
