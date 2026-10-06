// Doc Sign, signing page, forms in parts: what every control for a data field is given.

import type { DataAnswerInput, DataField } from "@/lib/sign/forms/types";

export interface ControlProps {
  field: DataField;
  /** The id of the control (a group's controls build theirs from it). */
  id: string;
  /** What the control shows: what the person typed, or the stored answer. */
  input: DataAnswerInput;
  /** An answer is marked as not right: the control says so to a screen reader and wears the red border. */
  invalid: boolean;
  /** The ids of the help and error text to read with the control. */
  describedBy?: string;
  onInput: (input: DataAnswerInput) => void;
  /** The person left the control: the moment to say what is wrong with a half-finished answer. */
  onBlur: () => void;
}

export const inputText = (input: DataAnswerInput): string => (typeof input.text === "string" ? input.text : "");
export const inputList = (input: DataAnswerInput): string[] => (Array.isArray(input.list) ? input.list.filter((x): x is string => typeof x === "string") : []);
export const inputChoices = (input: DataAnswerInput): string[] => (Array.isArray(input.choices) ? input.choices.filter((x): x is string => typeof x === "string") : []);
