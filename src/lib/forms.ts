export type FormResult = {
  message: string;
  errorCode?: string;
  retryable?: boolean;
  success?: boolean;
};

export const initialFormResult: FormResult = { message: "" };
