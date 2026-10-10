import Link from "next/link";
import { requireRole } from "@/lib/auth/role";
import { signOut } from "@/app/(auth)/login/actions";
import { HeaderMenu } from "@/app/header-menu";
import { ScrollHeader } from "@/app/scroll-header";

export default async function AdminLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  await requireRole("admin");

  return (
    <div className="app-shell">
      <ScrollHeader>
        <Link className="brand" href="/admin">
          <img src="/images/icon.png" width="32" height="32" alt="" />
          <span>디자이너를 위한 AI 질문 생성 도구</span>
        </Link>
        <HeaderMenu label="관리자 메뉴">
          <Link href="/admin">대시보드</Link>
          <Link href="/admin/participants">계정관리</Link>
          <Link href="/admin/errors">오류기록</Link>
          <form action={signOut}>
            <button className="button-secondary" type="submit">
              로그아웃
            </button>
          </form>
        </HeaderMenu>
      </ScrollHeader>
      <main className="page-container">{children}</main>
    </div>
  );
}
