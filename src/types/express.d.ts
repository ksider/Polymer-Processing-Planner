declare global {
  namespace Express {
    interface User {
      id: number;
      name?: string | null;
      email: string;
      role: string | null;
      status: string;
      temp_password: number;
    }
  }
}

export {};

declare module "express-session" {
  interface SessionData {
    passport?: {
      user?: number;
    };
  }
}
