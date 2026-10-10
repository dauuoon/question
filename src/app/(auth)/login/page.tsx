import { getErrorDefinition } from "@/lib/errors/catalog";
import { signIn } from "./actions";
import { Toast } from "@/app/toast";

type LoginPageProps = {
  searchParams: Promise<{ error?: string }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { error } = await searchParams;
  const errorDefinition = error ? getErrorDefinition(error) : null;

  return (
    <main className="auth-shell">
      <section className="auth-card" aria-labelledby="login-title">
        <header className="auth-heading">
          <h1 id="login-title" className="page-title">
            로그인
          </h1>
          <p className="eyebrow">디자이너를 위한 AI 질문 생성 도구</p>
        </header>
        <form action={signIn} className="form-stack">
          <div className="auth-field">
            <label htmlFor="identifier">아이디</label>
            <input
              id="identifier"
              name="identifier"
              autoComplete="username"
              required
            />
          </div>
          <div className="auth-field">
            <label htmlFor="password">비밀번호</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </div>
          {errorDefinition ? (
            <Toast error message={`${errorDefinition.participantMessage} (${error})`} />
          ) : null}
          <button type="submit">로그인</button>
        </form>
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
  );
}
