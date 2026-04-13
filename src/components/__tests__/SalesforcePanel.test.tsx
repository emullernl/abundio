import { render, screen } from "@testing-library/react";
import SalesforcePanel from "../../../plugins/salesforce/SalesforcePanel";

// Mock the IPC
vi.mock("../../lib/ipc", () => ({
	salesforce: {
		orgList: vi.fn().mockResolvedValue([]),
	},
}));

describe("SalesforcePanel", () => {
	it("renders without crashing", () => {
		render(<SalesforcePanel />);
		expect(screen.getByText("Salesforce Orgs")).toBeInTheDocument();
	});
});