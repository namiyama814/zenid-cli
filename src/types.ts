export interface ProfileField { fieldName: string; displayName: string; type: string; value: string }
export interface Role { id: number; roleId: number; name: string; displayName: string; from: number; to: number | null; removedReason: string | null; suspendings: unknown[] }
export interface Membership {
  id: number; accountId: string;
  organization: { id: number; name: string; displayName: string };
  joinedAt: number; leftAt: number | null;
  profile: { specVersion: number; fields: ProfileField[] };
  roleAssignings: Role[];
}
export interface Account { id: string; email: string; emailVerified: boolean; changePasswordUrl?: string; memberships: Membership[] }
export interface AuthenticationMethod { id: string; type: string; createdAt: number }
export interface Credential { token: string; expiresAt: number | null }
