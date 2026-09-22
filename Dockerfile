# Используем легковесный Debian, чтобы не было проблем с компиляцией better-sqlite3
FROM node:20-bookworm-slim

ENV NODE_ENV=production

# Создаем рабочую директорию
WORKDIR /app

# Копируем файлы зависимостей
COPY package*.json ./

# Устанавливаем все зависимости (включая devDependencies для сборки TS)
RUN npm ci --include=dev

# Копируем весь остальной код
COPY . .

# Компилируем TypeScript (команда "build": "tsc" из package.json)
RUN npm run build

# Runtime does not need the TypeScript toolchain or test dependencies.
RUN npm prune --omit=dev

# Открываем порт (предполагаем, что сервер слушает 3000)
EXPOSE 3000

# Запускаем скомпилированный код
CMD ["npm", "start"]
