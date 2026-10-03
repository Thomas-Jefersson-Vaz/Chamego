export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'Objeto JSON obrigatório.');
  return value as Record<string, any>;
}
export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ApiError(400, 'UUID inválido.');
  return value.toLowerCase();
}
export function text(value: unknown, max = 255): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ApiError(400, 'Texto inválido.');
  return value.trim();
}
export function date(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value) || !Number.isFinite(Date.parse(value))) throw new ApiError(400, 'Data inválida.');
  const calendar=value.slice(0,10);
  const midnight=new Date(`${calendar}T00:00:00Z`);
  if (!Number.isFinite(midnight.getTime()) || midnight.toISOString().slice(0,10)!==calendar) throw new ApiError(400, 'Data invalida.');
  return new Date(value).toISOString();
}
export function choice(value: unknown, values: string[]): string {
  if (typeof value !== 'string' || !values.includes(value)) throw new ApiError(400, 'Opção inválida.');
  return value;
}
export const relationshipTypes = ['Monogâmico(a)', 'Bi-amoroso(a)', 'Poliamoroso(a)'];
