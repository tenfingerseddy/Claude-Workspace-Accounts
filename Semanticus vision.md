# Semanticus Vision

_Clean-verbatim transcript. Lightly formatted for punctuation and paragraph breaks; product names have been corrected where unambiguous._

## Transcript

The vision for Semanticus is to be the best way to interact with semantic models using AI. In a way, it acts almost like an agent harness in between an AI assistant and semantic models.

Workflows align with graph engineering. It allows us to expose tools via the MCP. One of the big benefits is that the MCP allows us to dictate very carefully how AI does things and what it does.

And that's one of the big moats or differentiators from other tools, is that instead of pointing AI blindly at a semantic model, routing it through Semanticus adds the governance on top of the AI to ensure that it does things the right way and performs the right checks and balances.

It also is a polished, professional, well-engineered, production-ready tool that doesn't cobble together things from open source, but stands alone on its own high-end code. It's a very premium product.

UX design and the interface is a key priority. It needs to be extremely easy to use and aimed at all types of users, from business analysts through to pro devs. We can't assume that a professional tool for professional developers means that professional developers understand everything and talk in technical terms.

So language and interface is always very simple, plain language, Zen, minimal, friendly, and easy to use. We always obscure all the complexity in the back end. The interface is simple, friendly, easy to use.

The workflows side of Semanticus is one of the most powerful features, as well as the verification side of things and the governance and checks and balances. But for the workflow side of things, it really aligns with current trends in graph engineering.

And I want to redesign the interface for workflows around graph engineering: more of a canvas where you can drag and drop different MCP operations and verifications, checks that you want Claude to perform, evidence, user input, all the different types of way that you can interact, and then draw them on a canvas and link them together so that you can run things in sequence or parallel.

You can run loops. You can decide where things get verified and how, where the gates are, where things stop. I want it to enable developers to be able to build very sophisticated AI workflows for semantic models so that they can do one-shot solutions, but have them performed in a way that's very structured and with very deterministic outputs.

So we need to do some deep research on graph engineering and very much rethink the workflows interface to allow dragging and dropping operations, connecting them for sequence, and being able to operate them in parallel.

It's very similar—and because it's a data product, it's quite similar—to the data-pipeline-authoring experience in Microsoft Fabric or ADF, where you have different types of operations. You have on success, on execution. You know, you have different logic conditions, for-each loops, things like that.

So I think we need to base the design on ADF and Fabric data pipelines' kind of authoring experience, but make it better, and then build that same kind of canvas—but instead of pipeline operations, it's MCP operations, Claude instructions, evidence, gates, verifications.

We need to categorise all the operations so that it's very simple for users to understand. And then they also need to drop in some logic operators like for-eaches or conditional logic, or whatever we need to be able to design those graphs that allow sophisticated graph-engineering-type operations.

It would also be interesting to incorporate sub-agents into this, to have the ability to instruct Claude to delegate sub-agents for tasks, but that's probably a later phase.

I guess to sum it up, key things about Semanticus is it's everything you need for a semantic model development, but it's not over-complicated. It brings everything you need to do together, but it's simple to use.

It does all of the operations in a way that's better than existing tools, and it's the only tool that provides a shared canvas for collaboration with AI. It's designed from the ground up to work as a tool that's collaborative with AI, because the problem with using just an MCP is there's no visibility or control, and the problem with using just a tool is it doesn't integrate with AI that well.
