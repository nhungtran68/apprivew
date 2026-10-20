import type { Metadata, Viewport } from 'next';
import './globals.css';
import './responsive.css';
export const metadata:Metadata={metadataBase:new URL('https://ibeetool.com'),title:'Lời Kể AI — Không gian sáng tạo cho kinh doanh',description:'Nền tảng công cụ AI cho nội dung, giọng nói, hình ảnh và video của người kinh doanh online.',icons:{icon:'/favicon.svg'}};
export const viewport:Viewport={width:'device-width',initialScale:1,viewportFit:'cover',themeColor:'#1b3027'};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="vi" data-scroll-behavior="smooth"><body>{children}</body></html>;}
