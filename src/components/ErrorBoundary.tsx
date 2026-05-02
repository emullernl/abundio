import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
	children: ReactNode;
	fallback: (error: Error, reset: () => void) => ReactNode;
}

interface State {
	error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
	state: State = { error: null };

	static getDerivedStateFromError(error: Error): State {
		return { error };
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		console.error(
			"[ErrorBoundary] Caught render error:",
			error,
			info.componentStack,
		);
	}

	reset = () => {
		this.setState({ error: null });
	};

	render() {
		if (this.state.error) {
			return this.props.fallback(this.state.error, this.reset);
		}
		return this.props.children;
	}
}
