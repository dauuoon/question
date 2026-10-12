import { getErrorDefinition } from "@/lib/errors/catalog";
import { signIn } from "./actions";
import { cookies } from "next/headers";
import { LoginForm } from "./login-form";
import { LoginTheme } from "./login-theme";

type LoginPageProps = {
  searchParams: Promise<{ error?: string }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { error } = await searchParams;
  const errorDefinition = error ? getErrorDefinition(error) : null;
  const initialTheme = (await cookies()).get("why-box-theme")?.value === "dark" ? "dark" : "light";

  return (
    <LoginTheme initialTheme={initialTheme}>
    <main className="auth-shell">
      <section className="auth-card" aria-labelledby="login-title">
        <header className="auth-heading">
          <h1 id="login-title" className="page-title">
            로그인
          </h1>
          <p className="eyebrow">디자이너를 위한 AI 질문 생성 도구</p>
        </header>
        <LoginForm action={signIn} errorMessage={errorDefinition ?
          `${errorDefinition.participantMessage} (${error})` : undefined} />
        <p className="auth-help">
          <a
            href="https://open.kakao.com/o/sv6VztYh"
            target="_blank"
            rel="noopener noreferrer"
          >
            아이디·비밀번호 문의
          </a>
        </p>
      </section>
    </main>
    </LoginTheme>
  );
}
