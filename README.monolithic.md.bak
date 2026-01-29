# 🤖 Kube Assistant

AI-powered Kubernetes cluster management assistant. Natural language interface for K8s resource queries, log analysis, and cluster monitoring using OpenAI.

## ✨ Features

- **Natural Language Interface**: Ask questions about your Kubernetes cluster in plain language
- **Multi-turn Tool Calling**: AI can make multiple tool calls to gather information before responding
- **Real-time Log Streaming**: View pod logs with WebSocket-based real-time streaming
- **Cluster View**: Visual node-based pod layout with health status indicators
- **Dashboard & Monitoring**: Overview of cluster resources, namespaces, and metrics
- **Topology Visualization**: Network topology and service relationships

## 🛠️ Tech Stack

### Backend
- **FastAPI**: Python web framework
- **PostgreSQL**: Database for chat sessions and messages
- **OpenAI GPT**: AI model with function calling support
- **Kubernetes Python Client**: K8s API integration
- **WebSocket**: Real-time log streaming

### Frontend
- **React + TypeScript**: Modern UI framework
- **Tailwind CSS**: Utility-first styling
- **React Query**: Data fetching and caching
- **React Markdown**: Markdown rendering for AI responses

## 🚀 Quick Start

### Prerequisites

- Docker & Docker Compose
- Kubernetes cluster access (kubeconfig)
- OpenAI API key

### Installation

1. Clone the repository:
```bash
git clone https://github.com/junginho0901/kube-assistant.git
cd kube-assistant
```

2. Create `.env` file:
```bash
cp .env.example .env
# Edit .env and add your OpenAI API key
```

3. Place your `kubeconfig.yaml` in the root directory

4. Start services:
```bash
docker-compose up -d
```

5. Access the application:
- Frontend: http://localhost:5173
- Backend API: http://localhost:8000

## 📋 Configuration

### Environment Variables

Create a `.env` file with the following variables:

```env
OPENAI_API_KEY=your-api-key-here
DATABASE_URL=postgresql+asyncpg://kagent:kagent123@postgres:5432/kagent
KUBECONFIG_PATH=/app/kubeconfig.yaml
```

### Kubernetes Access

Place your `kubeconfig.yaml` file in the project root. The backend will use this to connect to your Kubernetes cluster.

## 🎯 Usage

### AI Chat

Ask questions about your cluster in natural language:

- "죽어 있는 파드들 원인 찾아줘"
- "CPU 사용률이 높은 리소스는?"
- "네임스페이스 뭐뭐 있는지 알려줘"

The AI will automatically use appropriate Kubernetes tools to gather information and provide answers.

### Cluster View

- View pods organized by node
- Click on any pod to see details, manifest, and logs
- Real-time log streaming for container logs
- Filter by namespace

### Dashboard

- Overview of cluster resources
- Namespace management
- Resource metrics

## 📁 Project Structure

```
.
├── backend/          # FastAPI backend
│   ├── app/
│   │   ├── api/      # API endpoints
│   │   ├── models/  # Database models
│   │   └── services/ # Business logic
├── frontend/        # React frontend
│   └── src/
│       ├── pages/   # Page components
│       └── services/# API clients
└── docker-compose.yml
```

## 🔧 Development

### Backend Development

```bash
cd backend
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload
```

### Frontend Development

```bash
cd frontend
npm install
npm run dev
```

## 📝 License

MIT License

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📧 Contact

For questions or issues, please open an issue on GitHub.
