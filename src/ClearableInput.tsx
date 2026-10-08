import { useRef, type InputHTMLAttributes } from "react";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  value: string;
  onValueChange(value: string): void;
  onClear?(): void;
  clearLabel: string;
  canClear?: boolean;
};

export default function ClearableInput({ value, onValueChange, onClear, clearLabel, canClear, ...props }: Props) {
  const input = useRef<HTMLInputElement>(null);
  return <div className="clearable-input">
    <input {...props} ref={input} value={value} onChange={event => onValueChange(event.target.value)}/>
    {(value || canClear) && <button type="button" className="input-clear" aria-label={clearLabel} title={clearLabel} disabled={props.disabled}
      onClick={() => { if (onClear) onClear(); else onValueChange(""); input.current?.focus({ preventScroll: true }); }}>×</button>}
  </div>;
}
