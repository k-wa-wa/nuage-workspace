import plugins, {
  RULE_ENTRY_CSS_GUARDRAILS,
  RULE_HOVER_MEDIA_QUERY,
  RULE_NO_RAW_COLOR,
} from "./stylelint-plugin.mjs";

/**
 * 検査対象種別に応じた Stylelint 設定を生成する。
 *
 * @param {{ isEntryCss?: boolean }} [options]
 */
export function createStylelintConfig(options = {}) {
  const isEntryCss = Boolean(options.isEntryCss);
  return {
    plugins,
    rules: {
      [RULE_NO_RAW_COLOR]: [true, { isEntryCss }],
      [RULE_HOVER_MEDIA_QUERY]: true,
      [RULE_ENTRY_CSS_GUARDRAILS]: isEntryCss ? true : null,
    },
  };
}

export default createStylelintConfig({ isEntryCss: false });
