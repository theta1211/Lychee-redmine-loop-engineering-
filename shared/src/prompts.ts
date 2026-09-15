import type { RedmineIssue } from "./redmineClient";

export function buildImplementPrompt(issue: RedmineIssue, reviewFeedback?: string): string {
  const base = [
    `# チケット #${issue.id}: ${issue.subject}`,
    "",
    issue.description || "(説明なし)",
  ];
  if (reviewFeedback) {
    base.push(
      "",
      "## レビュー指摘（前回の実装への差し戻し）",
      reviewFeedback,
      "",
      "上記の指摘を踏まえて修正してください。"
    );
  } else {
    base.push("", "上記のチケット内容を実装してください。");
  }
  return base.join("\n");
}

export function buildReviewPrompt(issue: RedmineIssue, diffSummary: string): string {
  return [
    `# チケット #${issue.id}: ${issue.subject} のレビュー`,
    "",
    issue.description || "(説明なし)",
    "",
    "## 差分",
    diffSummary,
    "",
    "上記の差分をレビューし、出力の先頭行に `RESULT: PASS` または `RESULT: FAIL` を",
    "明記してください。FAILの場合は具体的な指摘内容を続けて記載してください。",
  ].join("\n");
}
