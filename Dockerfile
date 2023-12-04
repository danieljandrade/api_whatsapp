# Escolha a imagem base do Node.js
FROM node:18.13

# Crie o diretório da aplicação
WORKDIR /app

# Copie o package.json e o package-lock.json
COPY package*.json ./

# Instale as dependências do projeto
#RUN npm install

# Copie o restante dos arquivos do projeto
COPY . .

# Expõe a porta na qual o aplicativo irá rodar
EXPOSE 8000

# Comando para executar o aplicativo
CMD [ "npm", "run", "start" ]
