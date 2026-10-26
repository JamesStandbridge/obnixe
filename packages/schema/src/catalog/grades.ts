const fontainebleau = ["3", "4", "4+", "5", "5+", "6A", "6A+", "6B", "6B+", "6C", "6C+", "7A", "7A+", "7B", "7B+", "7C", "7C+", "8A", "8A+", "8B", "8B+", "8C", "8C+", "9A"] as const;
const french = ["3", "4a", "4b", "4c", "5a", "5b", "5c", "6a", "6a+", "6b", "6b+", "6c", "6c+", "7a", "7a+", "7b", "7b+", "7c", "7c+", "8a", "8a+", "8b", "8b+", "8c", "8c+", "9a", "9a+", "9b", "9b+", "9c"] as const;

export const gradeScales = {
  fontainebleau: { label: "Fontainebleau", grades: fontainebleau },
  french: { label: "Cotation française", grades: french },
} as const satisfies Record<string, { readonly label: string; readonly grades: readonly [string, ...string[]] }>;

export type GradeScaleKey = keyof typeof gradeScales;
