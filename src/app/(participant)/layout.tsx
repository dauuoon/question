import Link from "next/link";
import { requireRole } from "@/lib/auth/role";
import { signOut } from "@/app/(auth)/login/actions";
import { cookies } from "next/headers";
import { ParticipantTheme } from "./participant-theme";
import { HeaderMenu } from "@/app/header-menu";
import { ScrollHeader } from "@/app/scroll-header";

export default async function ParticipantLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  await requireRole("participant");
  const initialTheme = (await cookies()).get("why-box-theme")?.value === "dark" ? "dark" : "light";

  return (
    <ParticipantTheme initialTheme={initialTheme}>
      <ScrollHeader>
        <a className="brand" href="/">
          <img src="/images/icon.png" width="32" height="32" alt="" />
          <span>디자이너를 위한 AI 질문 생성 도구</span>
        </a>
        <HeaderMenu label="참여자 메뉴">
          <a href="/">홈</a>
          <Link href="/history">나의기록</Link>
          <form action={signOut}>
            <button className="button-secondary" type="submit">
              로그아웃
            </button>
          </form>
        </HeaderMenu>
      </ScrollHeader>
      <main className="page-container">{children}</main>
    </ParticipantTheme>
  );
}
