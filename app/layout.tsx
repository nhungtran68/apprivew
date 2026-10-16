import type { Metadata } from 'next';
import './globals.css';
export const metadata:Metadata={title:'Lời Kể Studio — Kể câu chuyện của bạn',description:'Quay video thật, chia sẻ đúng ý, bằng giọng của bạn.',icons:{icon:'/favicon.svg'}};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="vi"><body>{children}</body></html>;}
