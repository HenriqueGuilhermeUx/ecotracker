export const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000/api";

export async function api<T>(path:string, options:RequestInit={}):Promise<T>{
  const token=localStorage.getItem("ecotracker_admin_token");
  const headers=new Headers(options.headers);
  if (!(options.body instanceof FormData)) headers.set("Content-Type","application/json");
  if(token) headers.set("Authorization",`Bearer ${token}`);
  const response=await fetch(`${API_URL}${path}`,{...options,headers});
  const data=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(data.error||"Falha na operação");
  return data as T;
}
