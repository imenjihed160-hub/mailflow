# ✉️ MailFlow — خدمة إرسال إيميلات مجانية

بديل مجاني ومفتوح المصدر لـ EmailJS، أسرع وأكثر تحكماً.

---

## 📁 هيكل المشروع

```
mailflow/
├── backend/
│   ├── server.js        ← API Server (Express + SQLite)
│   └── package.json
├── frontend/
│   └── dashboard.html   ← لوحة التحكم الكاملة
├── sdk/
│   └── mailflow.js      ← JavaScript SDK
└── README.md
```

---

## 🚀 التشغيل المحلي (5 دقائق)

### 1. Backend

```bash
cd backend
npm install
node server.js
# ✅ يعمل على http://localhost:3001
```

### 2. Frontend

افتح `frontend/dashboard.html` في المتصفح مباشرة، أو:

```bash
npx serve frontend
# http://localhost:3000
```

---

## ⚙️ إعداد الإيميل (Gmail)

1. فعّل **2-Factor Authentication** على حساب Gmail
2. أنشئ **App Password** من: https://myaccount.google.com/apppasswords
3. في لوحة التحكم → **خدمات SMTP** → أضف خدمة جديدة:

```
SMTP Host:  smtp.gmail.com
SMTP Port:  587
User:       your@gmail.com
Password:   xxxx xxxx xxxx xxxx  ← App Password
```

---

## 📦 استخدام SDK في موقعك

### HTML

```html
<script src="https://your-backend.com/sdk.js"></script>
<script>
  MailFlow.init('pk_xxxxxxxxxxxxxxxx')

  document.getElementById('form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const result = await MailFlow.send({
      template_id: 'your_template_id',
      to_email:    'you@example.com',
      params: {
        name:    e.target.name.value,
        message: e.target.message.value
      }
    })
    if (result.ok) alert('تم الإرسال!')
  })
</script>
```

### React

```jsx
import MailFlow from 'mailflow-js'
MailFlow.init('pk_xxxxxxxxxxxxxxxx')

async function sendEmail() {
  const result = await MailFlow.send({
    template_id: 'contact_form',
    to_email: 'you@example.com',
    params: { name, message }
  })
  if (result.ok) setSuccess(true)
}
```

### REST API

```bash
curl -X POST https://your-backend.com/v1/send \
  -H "Content-Type: application/json" \
  -H "X-Public-Key: pk_your_key" \
  -d '{
    "template_id": "contact_form",
    "to_email": "test@example.com",
    "params": { "name": "أحمد", "message": "مرحباً!" }
  }'
```

---

## 🌐 النشر المجاني

### Railway (موصى به)
```bash
# 1. ارفع الكود على GitHub
# 2. اذهب إلى railway.app
# 3. New Project → Deploy from GitHub
# 4. اختر مجلد backend
# الخادم سيعمل تلقائياً!
```

### Render
```bash
# render.com → New Web Service
# Build Command: npm install
# Start Command: node server.js
```

### Vercel (يحتاج تعديل بسيط)
```bash
npm i -g vercel
cd backend
vercel
```

---

## 📡 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/auth/register` | إنشاء حساب |
| POST | `/auth/login` | تسجيل الدخول |
| GET | `/templates` | جلب القوالب |
| POST | `/templates` | إنشاء قالب |
| PUT | `/templates/:id` | تعديل قالب |
| DELETE | `/templates/:id` | حذف قالب |
| GET | `/services` | جلب خدمات SMTP |
| POST | `/services` | إضافة خدمة |
| POST | `/services/test` | اختبار اتصال SMTP |
| GET | `/keys` | جلب مفاتيح API |
| POST | `/keys` | إنشاء مفتاح |
| GET | `/logs` | سجل الإيميلات |
| GET | `/stats` | الإحصاءات |
| **POST** | **`/v1/send`** | **إرسال إيميل** ← الأهم |

---

## 🔒 الأمان

- المفاتيح العامة (pk_) آمنة في كود الـ Frontend
- قيّد المفتاح بمجال محدد من لوحة التحكم
- Rate limiting: 10 إيميلات/دقيقة per IP
- كلمات المرور مُشفرة (SHA-256)

---

## 📊 الخطة المجانية مقارنةً بـ EmailJS

| الميزة | MailFlow (مجاني) | EmailJS (مجاني) |
|--------|-----------------|-----------------|
| إيميلات/شهر | **500** | 200 |
| قوالب | **غير محدود** | 2 |
| SDK | ✅ | ✅ |
| REST API | ✅ | ❌ |
| لوحة تحكم | ✅ | محدودة |
| مفتوح المصدر | ✅ | ❌ |
| SMTP خاص | ✅ | ❌ |

---

## 🛠 متطلبات التشغيل

- Node.js 18+
- npm

---

## 📝 الترخيص

MIT — مجاني للاستخدام الشخصي والتجاري
