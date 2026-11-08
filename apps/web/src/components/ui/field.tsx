import type {ReactNode,InputHTMLAttributes,SelectHTMLAttributes,TextareaHTMLAttributes} from 'react';import {cn} from '../../lib/utils';
export function Field({label,children,hint,error}:{label:string;children:ReactNode;hint?:string;error?:string}){return <label className="field"><span>{label}</span>{children}{hint&&<small>{hint}</small>}{error&&<small className="error-text" role="alert">{error}</small>}</label>;}
export function Input(props:InputHTMLAttributes<HTMLInputElement>){return <input {...props} className={cn('input',props.className)}/>;}
export function Select(props:SelectHTMLAttributes<HTMLSelectElement>){return <select {...props} className={cn('input',props.className)}/>;}
export function Textarea(props:TextareaHTMLAttributes<HTMLTextAreaElement>){return <textarea {...props} className={cn('input',props.className)}/>;}
