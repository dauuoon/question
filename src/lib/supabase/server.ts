import { createServerClient } from "@supabase/ssr";
import type { CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getPublicEnv } from "@/lib/env";

export async function createSupabaseServerClient(options?: {
  allowCookieWrites?: boolean;
}) {
  const cookieStore = await cookies();
  const env = getPublicEnv();

  return createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(
          cookiesToSet: {
            name: string;
            value: string;
            options: CookieOptions;
          }[],
        ) {
          if (options?.allowCookieWrites) {
            for (const { name, value, options: cookieOptions } of cookiesToSet) {
              cookieStore.set(name, value, cookieOptions);
            }
          }
        },
      },
    },
  );
}
