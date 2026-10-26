import type { ModelInfo } from '../api';

/** A native <select> dressed as a chip: the phone's own picker is the best UI for a short list. */
export function ModelPicker(props: {
  value: string;
  models: ModelInfo[];
  onChange: (modelId: string) => void;
  className?: string;
}) {
  const models = props.models.some((m) => m.modelId === props.value)
    ? props.models
    : [{ modelId: props.value, name: props.value }, ...props.models];
  return (
    <label className={`model-picker ${props.className ?? ''}`}>
      <span className="model-picker-label">{modelName(props.value, models)}</span>
      <select value={props.value} onChange={(e) => props.onChange(e.target.value)} aria-label="モデル">
        {models.map((m) => (
          <option key={m.modelId} value={m.modelId}>
            {m.modelId === 'auto' ? 'Auto（自動選択）' : m.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export function modelName(id: string, models: ModelInfo[]): string {
  if (id === 'auto') return 'Auto';
  return models.find((m) => m.modelId === id)?.name ?? id;
}
