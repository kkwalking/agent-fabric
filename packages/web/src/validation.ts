/**
 * Validation steps as the task-creation forms edit them (v11 §20).
 *
 * Both composers — the Projects view's task form and the sidebar New task
 * composer — take one command per line; the step name defaults to the
 * command's first word, which is what the Lifecycle view and the validation
 * report label each step with. The two forms share this parser so the same
 * text can never produce different steps depending on the entry point.
 */
export function parseValidationSteps(text: string): { name: string; command: string }[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((command) => ({ name: command.split(/\s+/)[0] || "step", command }));
}
