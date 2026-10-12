import { LoadingState } from "@/app/loading-state";

export function QuestionGenerationLoading({ message = "질문을 생성하고 있어요···" }: { message?: string }) {
  return <LoadingState variant="overlay">{message}</LoadingState>;
}
