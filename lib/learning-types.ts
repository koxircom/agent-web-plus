export interface LearningLesson {
  id: string;
  title: string;
  content: string;
  kind: "experience" | "skill";
  status: "active" | "candidate" | "dismissed" | "published";
  createdAt: string;
  updatedAt: string;
  occurrences: number;
  skillPath?: string;
  sourceReviewId?: string;
}
export interface LearningReview {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "skipped";
  updatedAt: string;
  error?: string;
  lessonCount?: number;
  sourceSessionId?: string;
  model?: string;
}
export interface LearningStatus {
  enabled: boolean;
  project: string | null;
  lessons: LearningLesson[];
  lastReview: LearningReview | null;
}
