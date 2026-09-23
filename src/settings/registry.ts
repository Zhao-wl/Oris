/**
 * 设置分类注册表（技术方案 §9.1）。每个分类声明自己的设置项：键、类型、默认值、校验与界面元数据。
 * 设置窗口按注册表渲染；新增分类只需注册，不改框架代码。
 */
export type SettingType = "enum" | "number" | "string" | "boolean";

export interface SettingUi {
  label: string;
  control: "segmented" | "select" | "slider" | "text" | "toggle" | "scheme-list";
  description?: string;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  /** 例如“待用户决定”的产品项，界面可据此标注。 */
  pendingDecision?: string;
}

export interface SettingDefinition<T = unknown> {
  key: string;
  type: SettingType;
  defaultValue: T;
  /** 返回规范化后的合法值；非法时返回 undefined（调用方回退为默认值或保留原值）。 */
  validate(value: unknown): T | undefined;
  ui: SettingUi;
}

export interface CategoryDefinition {
  id: string;
  label: string;
  order: number;
  settings: SettingDefinition[];
}

export type SettingsValues = Record<string, Record<string, unknown>>;

export class SettingsRegistry {
  private readonly categories = new Map<string, CategoryDefinition>();

  register(category: CategoryDefinition): this {
    if (this.categories.has(category.id)) throw new Error(`设置分类已注册：${category.id}`);
    const keys = new Set<string>();
    for (const setting of category.settings) {
      if (keys.has(setting.key)) throw new Error(`设置项重复：${category.id}.${setting.key}`);
      keys.add(setting.key);
      if (setting.validate(setting.defaultValue) === undefined) throw new Error(`默认值未通过校验：${category.id}.${setting.key}`);
    }
    this.categories.set(category.id, category);
    return this;
  }

  list(): CategoryDefinition[] {
    return [...this.categories.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  }

  definition(categoryId: string, key: string): SettingDefinition | undefined {
    return this.categories.get(categoryId)?.settings.find((setting) => setting.key === key);
  }

  defaults(): SettingsValues {
    const values: SettingsValues = {};
    for (const category of this.list()) {
      values[category.id] = Object.fromEntries(category.settings.map((setting) => [setting.key, setting.defaultValue]));
    }
    return values;
  }

  /** 逐项校验；缺失或非法的项回退为默认值，并报告被纠正的项。未注册的分类与键会被丢弃。 */
  normalize(raw: unknown): { values: SettingsValues; corrected: string[] } {
    const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const values: SettingsValues = {};
    const corrected: string[] = [];
    for (const category of this.list()) {
      const section = source[category.id];
      const input = section && typeof section === "object" ? (section as Record<string, unknown>) : {};
      values[category.id] = {};
      for (const setting of category.settings) {
        const present = Object.prototype.hasOwnProperty.call(input, setting.key);
        const valid = present ? setting.validate(input[setting.key]) : undefined;
        if (present && valid === undefined) corrected.push(`${category.id}.${setting.key}`);
        values[category.id][setting.key] = valid ?? setting.defaultValue;
      }
    }
    return { values, corrected };
  }
}

export const enumSetting = <T extends string>(key: string, values: readonly T[], defaultValue: T, ui: SettingUi): SettingDefinition<T> => ({
  key,
  type: "enum",
  defaultValue,
  validate: (value) => (typeof value === "string" && (values as readonly string[]).includes(value) ? (value as T) : undefined),
  ui: { ...ui, options: ui.options ?? values.map((value) => ({ value, label: value })) }
});

export const integerSetting = (key: string, min: number, max: number, defaultValue: number, ui: SettingUi): SettingDefinition<number> => ({
  key,
  type: "number",
  defaultValue,
  validate: (value) => (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : undefined),
  ui: { ...ui, min, max, step: 1 }
});

export const stringSetting = (key: string, defaultValue: string, ui: SettingUi, validate: (value: string) => boolean = () => true): SettingDefinition<string> => ({
  key,
  type: "string",
  defaultValue,
  validate: (value) => (typeof value === "string" && validate(value) ? value : undefined),
  ui
});
