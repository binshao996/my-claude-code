import {
  loadSettingsWithSources,
  setProjectSetting,
  SettingsSchema,
  THEME_NAMES,
  OUTPUT_STYLE_NAMES,
} from '@my-claude-code/settings'
import { z } from 'zod/v4'
import type { Settings } from '@my-claude-code/settings'
import type { Tool } from '../types.js'

const ConfigInputSchema = z.object({
  setting: z.string().min(1),
  value: z.union([
    z.string(),
    z.boolean(),
    z.number(),
    z.array(z.string()),
  ]).optional(),
})

type ConfigInput = z.infer<typeof ConfigInputSchema>

type SupportedConfigSetting = keyof Settings | 'permissions.defaultMode' | 'editorMode'

const SETTING_ALIASES: Record<string, keyof Settings> = {
  'permissions.defaultMode': 'permissionMode',
  editorMode: 'vimMode',
}

export const configTool: Tool<ConfigInput> = {
  name: 'ConfigTool',
  description: 'Get or set supported my-claude-code configuration settings.',
  inputSchema: ConfigInputSchema,
  inputJSONSchema: {
    type: 'object',
    properties: {
      setting: {
        type: 'string',
        description: 'Setting key such as theme, model, permissionMode, permissions.defaultMode, outputStyle, or vimMode.',
      },
      value: {
        oneOf: [
          { type: 'string' },
          { type: 'boolean' },
          { type: 'number' },
          { type: 'array', items: { type: 'string' } },
        ],
        description: 'New value. Omit to read the current value.',
      },
    },
    required: ['setting'],
  },
  isReadOnly: input => input.value === undefined,
  isDestructive: input => input.value !== undefined,
  isConcurrencySafe: () => true,
  checkPermissions: input =>
    input.value === undefined
      ? { decision: 'allow' }
      : {
          decision: 'ask',
          reason: `Set ${input.setting} to ${JSON.stringify(input.value)}`,
        },
  execute: async (input, context) => {
    const setting = normalizeSetting(input.setting)
    if (!setting) {
      return JSON.stringify({
        success: false,
        error: `Unknown setting: "${input.setting}"`,
        supportedSettings: supportedSettings(),
      }, null, 2)
    }

    const loaded = await loadSettingsWithSources(context.cwd)
    if (input.value === undefined) {
      return JSON.stringify({
        success: true,
        operation: 'get',
        setting: input.setting,
        normalizedSetting: setting,
        value: loaded.settings[setting],
        sources: loaded.sources
          .filter(source => source.exists)
          .map(source => ({ kind: source.kind, path: source.path })),
      }, null, 2)
    }

    const coerced = coerceSettingValue(setting, input.value)
    const next = SettingsSchema.safeParse({ [setting]: coerced })
    if (!next.success) {
      return JSON.stringify({
        success: false,
        operation: 'set',
        setting: input.setting,
        normalizedSetting: setting,
        error: next.error.message,
      }, null, 2)
    }

    const previousValue = loaded.settings[setting]
    const saved = await setProjectSetting(context.cwd, setting, next.data[setting])
    return JSON.stringify({
      success: true,
      operation: 'set',
      setting: input.setting,
      normalizedSetting: setting,
      previousValue,
      newValue: saved[setting],
    }, null, 2)
  },
}

function normalizeSetting(setting: string): keyof Settings | undefined {
  const key = (SETTING_ALIASES[setting] ?? setting) as SupportedConfigSetting
  if (key === 'permissions.defaultMode' || key === 'editorMode') {
    return SETTING_ALIASES[key]
  }
  if (supportedSettings().includes(key)) {
    return key as keyof Settings
  }
  return undefined
}

function supportedSettings(): Array<keyof Settings> {
  return [
    'model',
    'permissionMode',
    'allowedTools',
    'disallowedTools',
    'theme',
    'outputStyle',
    'vimMode',
  ]
}

function coerceSettingValue(setting: keyof Settings, value: ConfigInput['value']): Settings[keyof Settings] {
  if (setting === 'vimMode') {
    if (value === 'vim') {
      return true
    }
    if (value === 'default' || value === 'emacs') {
      return false
    }
  }
  if (setting === 'theme' && typeof value === 'string') {
    return THEME_NAMES.includes(value as typeof THEME_NAMES[number])
      ? value as Settings['theme']
      : value
  }
  if (setting === 'outputStyle' && typeof value === 'string') {
    return OUTPUT_STYLE_NAMES.includes(value as typeof OUTPUT_STYLE_NAMES[number])
      ? value as Settings['outputStyle']
      : value
  }
  return value as Settings[keyof Settings]
}
