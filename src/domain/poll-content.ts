export function pollQuestion(question: string) {
  return question
    .trim()
    .replace(/\s+#[1-9]\d*$/u, '')
    .trim();
}

export function pollAnswers(answers: readonly string[]) {
  return [...new Set(answers.map((answer) => answer.trim()))];
}
